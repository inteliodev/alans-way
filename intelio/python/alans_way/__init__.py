"""Alan's Way additions on top of the real intelio_harness loader.

Profile and pin loading stay in intelio_harness. This package reads an
optional alans-way.yaml sidecar (browsing zone, ask-first safety, Hermes
profile name) and probes the installed hermes command. It does not parse
pin/hermes.yaml itself.
"""

from alans_way.report import ForkRefusal, load_report

__all__ = ["ForkRefusal", "load_report"]
