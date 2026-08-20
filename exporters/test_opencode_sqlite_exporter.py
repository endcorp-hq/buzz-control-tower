import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

import opencode_sqlite_exporter as exporter


class OpenCodeExporterTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.database = Path(self.tempdir.name) / "opencode.db"
        connection = sqlite3.connect(self.database)
        connection.executescript(
            """
            CREATE TABLE session (
              id TEXT PRIMARY KEY, directory TEXT, model TEXT,
              time_updated INTEGER, title TEXT, version TEXT
            );
            CREATE TABLE message (
              id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
              time_updated INTEGER, data TEXT
            );
            CREATE TABLE part (
              id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
              time_created INTEGER, time_updated INTEGER, data TEXT
            );
            """
        )
        base = int(time.time() * 1000) - 120_000
        model = json.dumps({"providerID": "opencode", "id": "test-model", "variant": "high"})
        connection.execute(
            "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)",
            ("session", "/workspace", model, base + 5_000, "Withheld", "1.0"),
        )
        connection.execute(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
            ("user", "session", base, base, json.dumps({"role": "user"})),
        )
        connection.execute(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
            (
                "trigger",
                "user",
                "session",
                base,
                base,
                json.dumps(
                    {
                        "type": "text",
                        "text": (
                            "[Base]\nprivate platform policy\n"
                            "[Agent Memory — core]\ntoken=private-memory\n"
                            f"[Context]\nChannel: test (#{self.channel})\n"
                            "[Buzz event: @mention]\n"
                            "Event ID: abc\n"
                            "Content: Please make context inspectable; api_key=private-request\n"
                            "Tags: []\n"
                            "Parsed: mentions=[]"
                        ),
                    }
                ),
            ),
        )
        connection.execute(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
            (
                "assistant",
                "session",
                base + 1_000,
                base + 5_000,
                json.dumps({"role": "assistant", "finish": "stop"}),
            ),
        )
        parts = [
            (
                "reasoning",
                base + 1_000,
                {
                    "type": "reasoning",
                    "text": "Checking password=do-not-export",
                    "metadata": {"openai": {"reasoningEncryptedContent": "ciphertext"}},
                },
            ),
            (
                "bash",
                base + 2_000,
                {
                    "type": "tool",
                    "tool": "bash",
                    "state": {
                        "status": "completed",
                        "input": {"command": "echo ok; token=do-not-export"},
                        "output": "ok\nsecret=do-not-export",
                    },
                },
            ),
            (
                "read",
                base + 3_000,
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/workspace/private.txt"},
                        "output": "private file body",
                    },
                },
            ),
            (
                "patch",
                base + 4_000,
                {
                    "type": "tool",
                    "tool": "apply_patch",
                    "state": {
                        "status": "completed",
                        "input": {"patchText": "--- a/demo.txt\n+++ b/demo.txt\n@@ secret patch body"},
                        "output": "Done",
                    },
                },
            ),
            (
                "final",
                base + 5_000,
                {"type": "text", "text": "Finished safely."},
            ),
        ]
        for part_id, timestamp, data in parts:
            connection.execute(
                "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
                (part_id, "assistant", "session", timestamp, timestamp, json.dumps(data)),
            )
        connection.commit()
        connection.close()

    channel = "11111111-1111-4111-8111-111111111111"
    pubkey = "2" * 64

    def tearDown(self):
        self.tempdir.cleanup()

    def test_exports_feed_detail_without_sensitive_source_fields(self):
        page = exporter.build_page(
            {
                "agentName": "test-agent",
                "agentPubkey": self.pubkey,
                "database": str(self.database),
                "allowedChannels": [self.channel],
            },
            self.channel,
        )
        serialized = json.dumps(page)

        self.assertIn("Thinking", serialized)
        self.assertIn("Ran echo ok", serialized)
        self.assertIn("Finished safely", serialized)
        self.assertIn("demo.txt", serialized)
        self.assertNotIn("do-not-export", serialized)
        self.assertNotIn("private file body", serialized)
        self.assertNotIn("secret patch body", serialized)
        self.assertNotIn("reasoningEncryptedContent", serialized)
        self.assertNotIn("private platform policy", serialized)
        self.assertNotIn("private-memory", serialized)
        self.assertNotIn("private-request", serialized)
        trigger = next(source for source in page["context"] if source["label"] == "Triggering Buzz turn")
        self.assertEqual(trigger["content"], "Please make context inspectable; api_key=[redacted]")
        runtime = next(source for source in page["context"] if source["kind"] == "repository")
        self.assertEqual(runtime["fields"][0], {"label": "Workspace", "value": "workspace"})
        memory = next(source for source in page["context"] if source["kind"] == "memory")
        self.assertIsNone(memory["content"])
        self.assertIn("durable memory", memory["withheldReason"])
        read_event = next(event for event in page["activity"] if event["id"] == "read")
        self.assertIsNone(read_event["result"])


if __name__ == "__main__":
    unittest.main()
