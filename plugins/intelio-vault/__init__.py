"""Intelio vault plugin. Copy this directory to ~/.hermes/plugins/intelio-vault.

Hermes reads plugins when the gateway process starts. After copying, restart
the user gateway: systemctl --user restart hermes-gateway
The filler itself is the phone service on 127.0.0.1:8643. Restart
intelio-pwa.service when that code changes. The gateway restart is what
registers fill_saved_login.
"""
from .fill import SCHEMA, fill_saved_login


def register(ctx):
    ctx.register_tool(
        name="fill_saved_login",
        toolset="intelio",
        schema=SCHEMA,
        handler=fill_saved_login,
    )
