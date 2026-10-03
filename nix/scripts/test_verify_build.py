import base64
import unittest
from verify_build import output_hash


class HashEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.drv = "/nix/store/example-opencode-node_modules-test.drv"
        self.actual = "sha256-" + base64.b64encode(b"test" * 8).decode()
        self.fake = "sha256-" + base64.b64encode(bytes(32)).decode()
        self.log = f"error: hash mismatch in fixed-output derivation '{self.drv}':\n specified: {self.fake}\n got: {self.actual}\n"

    def test_accepts_only_the_requested_updater_measurement(self):
        self.assertEqual(output_hash(self.log, self.drv), self.actual)

    def test_rejects_other_dependency_mismatches_and_install_failures(self):
        for log in [self.log.replace(self.drv, "/nix/store/other-dependency.drv"), "error: bun install failed"]:
            with self.assertRaises(RuntimeError):
                output_hash(log, self.drv)

    def test_rejects_non_fake_or_ambiguous_measurements(self):
        for log in [self.log.replace(self.fake, self.actual), self.log + self.log]:
            with self.assertRaises(RuntimeError):
                output_hash(log, self.drv)


if __name__ == "__main__":
    unittest.main()
