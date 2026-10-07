# Cloudflare Tunnel ingress for key bootstrap

0.3.17 calls `GET https://app.intelio-ai.com/intelio/bootstrap` on the Access listener after Cloudflare Access sign-in, and only when no profile keys are stored yet. That route is served by the phone server. Older builds still call `GET https://os.intelio-ai.com/intelio/bootstrap`.

The route is served by `mobile/bootstrap/server.cjs` on `127.0.0.1:8660`. Install that with `mobile/deploy/install-bootstrap-endpoint.sh` on the VPS after review. The installer does not edit cloudflared, open a firewall port, or restart hermes-gateway.

Put this ingress rule **above** the `os.intelio-ai.com` catch-all that already maps to Hermes on port 8642:

```yaml
- hostname: os.intelio-ai.com
  path: ^/intelio/bootstrap$
  service: http://127.0.0.1:8660
```

The handler checks `Cf-Access-Jwt-Assertion` against the Access team certs and returns the profile `API_SERVER_KEY` values plus the desktop password. Responses use `Cache-Control: no-store`. The process does not log those values.
