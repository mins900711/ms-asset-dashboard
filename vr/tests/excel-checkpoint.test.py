import copy
import datetime as dt
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'excel_checkpoint.py'
spec = importlib.util.spec_from_file_location('excel_checkpoint', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(index, **values):
    return {'row': index, 'cells': {column + str(index): value for column, value in values.items()}}


def serial(value):
    return (dt.date.fromisoformat(value) - dt.date(1899, 12, 30)).days


class FundedCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            row(5, D=1000, N=2000, O=1400, H=10),
            row(9, B='Y', D=serial('2026-10-06'), E=serial('2026-10-19'), F=1000, I=10, J=100, O=500, P=900),
            row(10, B='N', D=serial('2026-10-20'), E=serial('2026-11-02'), F=1590, I=10, J=110, O=500, P=1400),
        ]

    def checkpoint(self, **overrides):
        args = dict(rows=self.rows, account='minsu', trade_date='2026-10-20', as_of='2026-10-26', funded=True)
        args.update(overrides)
        return module.checkpoint(**args)

    def test_funded_n_period_preserves_its_v_pool_and_contribution(self):
        result = self.checkpoint()
        self.assertEqual(result['principal'], 2000)
        self.assertEqual(result['pool'], 1400)
        self.assertEqual(result['v'], 1590)
        self.assertEqual(result['sourceDone'], 'N')
        self.assertEqual(result['quantity'], 0)

    def test_n_is_not_in_itself_evidence_of_a_completed_deposit(self):
        with self.assertRaises(ValueError):
            self.checkpoint(funded=False)

    def test_last_y_is_rejected_when_a_later_funded_checkpoint_exists(self):
        with self.assertRaises(ValueError):
            self.checkpoint(trade_date='2026-10-06')

    def test_future_period_cannot_be_imported(self):
        with self.assertRaises(ValueError):
            self.checkpoint(as_of='2026-10-19')

    def test_current_header_reconciliation_catches_missing_deposit(self):
        bad = copy.deepcopy(self.rows)
        bad[0]['cells']['N5'] = 1500
        with self.assertRaises(ValueError):
            self.checkpoint(rows=bad)


if __name__ == '__main__':
    unittest.main()
