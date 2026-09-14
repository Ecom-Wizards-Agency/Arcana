"""Arithmetic and export completeness checks, using synthetic colors only."""
import unittest
import resolve

class ResolveTests(unittest.TestCase):
    def test_transparent_retains_unassociated_rgb(self):
        actual = resolve.resolve_value('color-mix(in srgb, #FD4807 12%, transparent)', {}, set())
        for got, expected in zip(actual, (253, 72, 7, .12)):
            self.assertAlmostEqual(got, expected)

    def test_zero_alpha(self):
        self.assertEqual(resolve.resolve_value('color-mix(in srgb, transparent 50%, transparent)', {}, set()), (0, 0, 0, 0))

    def test_export_counts_and_determinism(self):
        exported = resolve.export_tokens()
        self.assertEqual(set(exported['colors']) | set(exported['nonColor']), set(resolve.L) | set(resolve.D))
        self.assertEqual(len(exported['colors']) + len(exported['nonColor']), len(set(resolve.L) | set(resolve.D)))
        self.assertEqual(exported, resolve.export_tokens())

if __name__ == '__main__':
    unittest.main()
