import base64
import copy
import unittest
from verify_build import output_hash, reviewed_inputs


class ReviewedInputsTest(unittest.TestCase):
    def setUp(self):
        self.lock = {"root": "root", "nodes": {
            "root": {"inputs": {
                "nixpkgs": ["nixpkgs-darwin"],
                "nixpkgs-unstable": "packages",
                "nixpkgs-darwin": "shell",
            }},
            "packages": {"locked": {"rev": "current"}},
            "shell": {"locked": {"rev": "legacy"}},
        }}

    def test_resolves_input_edges_instead_of_assuming_lock_node_names(self):
        reviewed_inputs(self.lock, "current", "legacy")

    def test_rejects_the_unsupported_default_bash_input(self):
        for target in ["packages", ["nixpkgs-unstable"]]:
            lock = copy.deepcopy(self.lock)
            lock["nodes"]["root"]["inputs"]["nixpkgs"] = target
            with self.assertRaisesRegex(RuntimeError, "resolve Bash"):
                reviewed_inputs(lock, "current", "legacy")

    def test_rejects_changed_package_revisions(self):
        for expected, legacy in [("stale", "legacy"), ("current", "stale")]:
            with self.assertRaises(RuntimeError):
                reviewed_inputs(self.lock, expected, legacy)


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
