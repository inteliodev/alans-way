"""Experimental bounded public JSON-RPC subscriber, never a live ingress.

No native Hermes imports, process creation, prompts, approvals, or retries.
A caller-reviewed profile label is metadata, not server attestation. Unsupported
server requests receive -32601, which can withdraw approval/clarify requests;
never attach to live sessions until request routing is separately handled.
"""
import json
import os
import select
import time


class KeeperError(RuntimeError):
    """Transport or reviewed public-contract observation failed closed."""


class StdioWire:
    """Caller-owned exclusive binary POSIX pipes; no launcher or authentication."""

    def __init__(self, reader, writer, *, send_timeout=10):
        if type(send_timeout) not in (int, float) or not 0 < send_timeout <= 60:
            raise KeeperError("send timeout must be within (0, 60]")
        self.reader, self.writer = reader, writer
        self.send_timeout = send_timeout
        os.set_blocking(writer.fileno(), False)
        self.buffer = b""

    def send(self, frame):
        data = json.dumps(frame, separators=(",", ":")).encode() + b"\n"
        if len(data) > 1048576:
            raise KeeperError("outgoing frame exceeded 1 MiB")
        deadline = time.monotonic() + self.send_timeout
        while data:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([], [self.writer], [], left)[1]:
                raise TimeoutError("JSON-RPC send timeout")
            try:
                data = data[os.write(self.writer.fileno(), data):]
            except BlockingIOError:
                continue

    def receive(self, timeout):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            if not select.select([self.reader], [], [], max(0, deadline - time.monotonic()))[0]:
                raise TimeoutError("JSON-RPC receive timeout")
            data = os.read(self.reader.fileno(), 65536)
            if not data:
                raise EOFError("JSON-RPC transport closed")
            self.buffer += data
            if len(self.buffer) > 1048576:
                raise KeeperError("JSON-RPC frame buffer exceeded 1 MiB")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)


class Keeper:
    """Finite observation only; explicit reattachment never restores durability."""

    def __init__(self, *, profile, session_key, session_id, reviewed=False, timeout=10):
        self.identity = dict(profile=profile, session_key=session_key, session_id=session_id)
        if reviewed is not True or any(not isinstance(value, str) or not value or value != value.strip()
                                       for value in self.identity.values()):
            raise KeeperError("explicit reviewed profile, stored key and live session ID required")
        if type(timeout) not in (int, float) or not 0 < timeout <= 60:
            raise KeeperError("timeout must be finite and within (0, 60]")
        self.timeout = timeout
        self.wire = None
        self.counter = 0
        self.state = {"status": "disconnected", "identity": self.identity.copy(), "last_seen": 0,
                      "open_requests": {}, "durable_admission": False, "epoch": None,
                      "epoch_changed": False, "truncated": False, "reconnects": 0}

    def _handle(self, frame):
        if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
            raise KeeperError("invalid JSON-RPC frame: contract drift")
        method = frame.get("method")
        if not isinstance(method, str) or not method or "result" in frame or "error" in frame:
            raise KeeperError("unexpected frame or response: contract drift")
        params = frame.get("params")
        if not isinstance(params, dict):
            raise KeeperError("JSON-RPC params contract drift")
        if frame.get("method") != "event" and "method" in frame and "id" in frame:
            rid = frame["id"]
            if not isinstance(rid, str) or not rid:
                raise KeeperError("server request ID contract drift")
            if "session_id" in params and params["session_id"] != self.identity["session_id"]:
                raise KeeperError("server request live identity drift")
            if rid not in self.state["open_requests"] and len(self.state["open_requests"]) >= 128:
                raise KeeperError("open request limit exceeded")
            self.wire.send({"jsonrpc": "2.0", "id": rid,
                            "error": {"code": -32601, "message": "keeper does not implement server requests"}})
            self.state["open_requests"][rid] = {"method": frame["method"], "status": "unsupported_error_sent"}
            return
        if frame.get("method") == "event":
            event = frame["params"]
            if "id" in frame or not isinstance(event.get("type"), str) or not event["type"]:
                raise KeeperError("event contract drift")
            if event.get("type") == "gateway.ready":
                epoch = event.get("payload", {}).get("replay_epoch")
                if not isinstance(epoch, str) or not epoch:
                    raise KeeperError("gateway.ready replay_epoch missing: contract drift")
                if self.state["epoch"] is not None and epoch != self.state["epoch"]:
                    self.state.update(epoch_changed=True, observed_epoch=epoch)
                    raise KeeperError("gateway epoch changed during observation")
                return
            if event.get("session_id") != self.identity["session_id"]:
                return
            seq = event.get("seq")
            if "seq" in event and (type(seq) is not int or seq < 1):
                raise KeeperError("session event sequence contract drift")
            if type(seq) is int and seq > self.state["last_seen"]:
                self.state["last_seen"] = seq
            if event.get("type") == "request.cancel":
                self.state["open_requests"].pop(event.get("payload", {}).get("id"), None)
            return
        raise KeeperError("unsupported notification: contract drift")

    def pump_once(self, timeout=None):
        if self.state["status"] != "attached":
            raise KeeperError("pump needs an attached transport; explicit review/attach required")
        timeout = self.timeout if timeout is None else timeout
        if type(timeout) not in (int, float) or not 0 < timeout <= 60:
            raise KeeperError("pump timeout must be finite and within (0, 60]")
        try:
            frame = self.wire.receive(timeout)
        except TimeoutError:
            raise
        except (EOFError, OSError) as exc:
            self.state.update(status="disconnected", error=str(exc))
            raise KeeperError(str(exc)) from exc
        except Exception as exc:
            self.state.update(status="blocked", error=str(exc))
            raise KeeperError(str(exc)) from exc
        try:
            self._handle(frame)
        except Exception as exc:
            self.state.update(status="blocked", error=str(exc))
            raise KeeperError(str(exc)) from exc

    def keep(self, *, seconds, interval=5):
        """Finite observation window, not a strict total-operation deadline."""
        if (self.state["status"] != "attached" or type(seconds) not in (int, float)
                or type(interval) not in (int, float) or not 0 < seconds <= 3600 or not 0 < interval <= seconds):
            raise KeeperError("keep needs an attached transport and 0 < interval <= seconds <= 3600")
        deadline = time.monotonic() + seconds
        probe_at = 0
        try:
            while time.monotonic() < deadline:
                if time.monotonic() >= probe_at:
                    if self._call("ping").get("pong") is not True:
                        raise KeeperError("ping contract drift")
                    rows = self._call("session.active_list")["sessions"]
                    if not any(row.get("id") == self.identity["session_id"] and
                               row.get("session_key") == self.identity["session_key"] for row in rows):
                        raise KeeperError("reviewed live identity lost")
                    probe_at = time.monotonic() + interval
                left = min(probe_at, deadline) - time.monotonic()
                if left > 0:
                    try:
                        self.pump_once(timeout=min(left, self.timeout))
                    except TimeoutError:
                        # Scripted peers can timeout immediately; a real wire waits.
                        time.sleep(min(left, 0.001))
        except Exception as exc:
            if self.state["status"] != "disconnected":
                self.state.update(status="blocked", error=str(exc))
            raise KeeperError(str(exc)) from exc

    def _call(self, method, params=None):
        if method not in {"gateway.capabilities", "client.capabilities", "session.active_list",
                          "session.activate", "session.events.since", "ping"}:
            raise KeeperError("keeper-only RPC allowlist: method refused")
        self.counter += 1
        rid = "keeper-" + str(self.counter)
        self.wire.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.monotonic() + self.timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise KeeperError("RPC deadline exceeded")
            frame = self.wire.receive(left)
            if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
                raise KeeperError("invalid JSON-RPC response: contract drift")
            if frame.get("id") == rid:
                if "method" in frame or ("error" in frame and "result" in frame):
                    raise KeeperError("ambiguous JSON-RPC response: contract drift")
                if "error" in frame:
                    # Remote error text/data can contain command or history content.
                    raise KeeperError("public RPC error; remote payload omitted")
                return frame["result"]
            self._handle(frame)

    def attach(self, wire):
        """Negotiate the supplied wire; never launch, discover, or authenticate."""
        self.wire = wire
        previous_epoch = self.state["epoch"]
        watermark = self.state["last_seen"]
        self.state["status"] = "connecting"
        try:
            deadline = time.monotonic() + self.timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise KeeperError("gateway.ready deadline exceeded")
                frame = wire.receive(left)
                if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
                    raise KeeperError("invalid handshake: contract drift")
                if frame.get("method") == "event" and frame.get("params", {}).get("type") == "gateway.ready":
                    self._handle(frame)
                    break
                self._handle(frame)
            epoch = frame["params"].get("payload", {}).get("replay_epoch")
            if not isinstance(epoch, str) or not epoch:
                raise KeeperError("gateway.ready replay_epoch missing: contract drift")
            if previous_epoch is not None and epoch != previous_epoch:
                self.state.update(epoch_changed=True, observed_epoch=epoch)
                raise KeeperError("gateway epoch changed; review owner/runtime identity before fresh keeper")
            self.state["epoch"] = epoch
            caps = self._call("gateway.capabilities")
            if not isinstance(caps, dict) or caps.get("per_session_exclusive_submit") is not True:
                raise KeeperError("required per_session_exclusive_submit unavailable")
            advertised = self._call("client.capabilities", {"server_requests": True})
            methods = advertised.get("server_requests")
            if not isinstance(methods, list) or not all(isinstance(method, str) for method in methods):
                raise KeeperError("server request negotiation contract drift")
            self.state["server_request_methods"] = methods
            rows = self._call("session.active_list")["sessions"]
            if not any(row.get("id") == self.identity["session_id"] and
                       row.get("session_key") == self.identity["session_key"] for row in rows):
                raise KeeperError("reviewed live canonical identity unavailable; no fallback")
            result = self._call("session.activate", {"session_id": self.identity["session_id"], "omit_messages": True})
            if any(result.get(key) != self.identity[key] for key in ("session_id", "session_key")):
                raise KeeperError("activated session identity drift")
            if not isinstance(result.get("open_requests", []), list):
                raise KeeperError("activation open_requests contract drift")
            for request in result.get("open_requests", []):
                self._handle(request)
            if previous_epoch is not None:
                replay = self._call("session.events.since", {"session_id": self.identity["session_id"], "last_seen": watermark})
                self.state["truncated"] = replay["truncated"]
                if replay["epoch"] != epoch or replay["truncated"] is not False:
                    raise KeeperError("replay gap/epoch drift; explicit reconciliation required")
                if type(replay["latest_seq"]) is not int or replay["latest_seq"] < watermark:
                    raise KeeperError("replay sequence contract drift")
                if not isinstance(replay["events"], list) or not isinstance(replay["open_requests"], list):
                    raise KeeperError("replay collections contract drift")
                for event in replay["events"]:
                    self._handle({"jsonrpc": "2.0", "method": "event", "params": event})
                self.state["last_seen"] = max(self.state["last_seen"], replay["latest_seq"])
                self.state["open_requests"] = {}
                for request in replay["open_requests"]:
                    self._handle(request)
                self.state["reconnects"] += 1
            self.state["status"] = "attached"
        except Exception as exc:
            self.state.update(status="blocked", error=str(exc))
            raise KeeperError(str(exc)) from exc
