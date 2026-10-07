"""Intelio vault plugin. Copy this directory to ~/.hermes/plugins/intelio-vault.

Hermes reads plugins when the gateway process starts. After copying, restart
the user gateway: systemctl --user restart hermes-gateway
The filler is the phone service. It listens on https://<tailnet-host>:8643
when ~/.config/intelio/pwa.env has INTELIO_PWA_CERT and INTELIO_PWA_KEY.
Set INTELIO_FILLER_URL in a hermes-gateway drop-in to override that file.
Restart intelio-pwa.service when the filler code changes. The gateway
restart is what registers fill_saved_login.
"""
from .fill import SCHEMA, fill_saved_login


def register(ctx):
    ctx.register_tool(
        name="fill_saved_login",
        toolset="intelio",
        schema=SCHEMA,
        handler=fill_saved_login,
    )
