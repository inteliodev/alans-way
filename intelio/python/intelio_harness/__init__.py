"""Intelio harness loader used by this Alan's Way fork.

The private inteliodev/intelio-harness repo was not readable here, so this
package implements the loader contract described for that repo: refuse to
start without profile.yaml or the Hermes pin, never vendor Hermes source,
and never report a failed command as success.
"""

from .loader import Refusal, load_profile

__all__ = ["Refusal", "load_profile"]
