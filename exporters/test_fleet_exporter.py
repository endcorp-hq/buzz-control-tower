import json
import tempfile
import unittest
from pathlib import Path

import fleet_exporter as exporter


class FleetExporterTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def source(self, name: str, command: list[str] | None = None, **extra):
        return {
            "agentPubkey": (name[0] * 64)[:64],
            "agentName": name,
            "sourceLabel": f"{name} host",
            "command": command,
            **extra,
        }

    def page_command(self, source):
        page = {
            "agentPubkey": source["agentPubkey"],
            "agentName": source["agentName"],
            "sourceLabel": source["sourceLabel"],
        }
        path = self.root / f"{source['agentName']}.json"
        path.write_text(json.dumps(page), encoding="utf-8")
        return ["/bin/cat", str(path)]

    def test_returns_healthy_pages_and_explicit_unavailable_sources(self):
        healthy = self.source("alpha")
        healthy["command"] = self.page_command(healthy)
        disabled = self.source("bravo", disabledReason="Continuity runtime is stopped.")
        disabled.pop("command")

        document = exporter.export_fleet({"sources": [healthy, disabled]})

        self.assertEqual([page["agentName"] for page in document["pages"]], ["alpha"])
        self.assertEqual(document["errors"][0]["agentName"], "bravo")
        self.assertIn("stopped", document["errors"][0]["detail"])

    def test_rejects_identity_substitution(self):
        expected = self.source("alpha")
        imposter = {**expected, "agentName": "imposter"}
        path = self.root / "imposter.json"
        path.write_text(json.dumps(imposter), encoding="utf-8")
        expected["command"] = ["/bin/cat", str(path)]

        document = exporter.export_fleet({"sources": [expected]})

        self.assertEqual(document["pages"], [])
        self.assertIn("identity", document["errors"][0]["detail"])


if __name__ == "__main__":
    unittest.main()
