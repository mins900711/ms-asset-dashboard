"""Read a user-confirmed funded Excel period, including a current N row.

Done=Y marks a finished period; it does not identify the latest funded balance.
This read-only tool requires an explicit funded-period confirmation. Its output
contains private account data and must never be committed to a public repository.
"""
import argparse
import datetime as dt
import json
import math
import pathlib
import posixpath
import xml.etree.ElementTree as ET
import zipfile

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_rows(path):
    with zipfile.ZipFile(path) as book:
        strings = []
        if 'xl/sharedStrings.xml' in book.namelist():
            strings = [''.join(node.itertext()) for node in ET.fromstring(book.read('xl/sharedStrings.xml'))]
        relationships = {
            node.attrib['Id']: posixpath.normpath('xl/' + node.attrib['Target'])
            for node in ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))
        }
        workbook = ET.fromstring(book.read('xl/workbook.xml'))
        sheet = next(node for node in workbook.find('m:sheets', NS) if node.attrib['name'] == '적립식')
        target = relationships[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        result = []
        for row in ET.fromstring(book.read(target)).findall('m:sheetData/m:row', NS):
            cells = {}
            for cell in row:
                cached = cell.find('m:v', NS)
                value = cached.text if cached is not None else None
                if cell.attrib.get('t') == 's' and value is not None:
                    value = strings[int(value)]
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(cell.find('m:is', NS).itertext())
                elif value is not None:
                    try:
                        value = float(value)
                    except ValueError:
                        pass
                cells[cell.attrib['r']] = value
            result.append({'row': int(row.attrib['r']), 'cells': cells})
        return result


def cell(row, column):
    return row['cells'].get(column + str(row['row']))


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def excel_date(value):
    if not number(value) or value != int(value):
        raise ValueError('A cached Excel date is required')
    return (dt.date(1899, 12, 30) + dt.timedelta(days=int(value))).isoformat()


def checkpoint(rows, account, trade_date, as_of, funded=False):
    trade = dt.date.fromisoformat(trade_date)
    snapshot = dt.date.fromisoformat(as_of)
    if account not in ('minsu', 'bobae') or trade.weekday() != 1:
        raise ValueError('Select an account and a Tuesday trade date')
    if not funded:
        raise ValueError('Confirm that the selected period contribution was actually funded; N alone is not confirmation')
    periods = [row for row in rows if row['row'] >= 9 and cell(row, 'B') in ('Y', 'N') and number(cell(row, 'I'))]
    available = [row for row in periods if excel_date(cell(row, 'D')) <= as_of]
    if not available:
        raise ValueError('No populated period exists at the snapshot date')
    selected = max(available, key=lambda row: excel_date(cell(row, 'D')))
    if excel_date(cell(selected, 'D')) != trade_date:
        raise ValueError('The checkpoint must be the latest populated period, not merely the last Y row')
    if not trade <= snapshot <= dt.date.fromisoformat(excel_date(cell(selected, 'E'))):
        raise ValueError('The snapshot date must be within the selected period')
    values = {key: cell(selected, column) for key, column in {'v': 'F', 'holdings': 'I', 'pool': 'P', 'price': 'J', 'contribution': 'O'}.items()}
    if not all(number(value) for value in values.values()):
        raise ValueError('Missing cached checkpoint values')
    if values['v'] <= 0 or values['pool'] < 0 or values['price'] <= 0 or values['holdings'] < 0 or values['holdings'] != int(values['holdings']):
        raise ValueError('Invalid checkpoint values')
    header = next(row for row in rows if row['row'] == 5)
    initial = cell(header, 'D')
    contributions = [cell(row, 'O') for row in periods if row['row'] <= selected['row']]
    if not number(initial) or not all(number(value) and value >= 0 for value in contributions):
        raise ValueError('Invalid contribution ledger')
    principal = initial + sum(contributions)
    if selected is periods[-1]:
        for actual, column in [(principal, 'N'), (values['pool'], 'O'), (values['holdings'], 'H')]:
            expected = cell(header, column)
            if not number(expected) or abs(actual - expected) > 0.0001:
                raise ValueError('Checkpoint does not reconcile to the workbook current balance')
    previous = next((row for row in reversed(periods) if row['row'] < selected['row']), None)
    result = {
        'id': account + '-excel-checkpoint-' + str(selected['row']), 'account': account,
        'cycleDate': trade_date, 'asOf': as_of, **values,
        'holdings': int(values['holdings']), 'principal': principal,
        'quantity': int(values['holdings'] - cell(previous, 'I')) if previous else 0,
        'assets': values['holdings'] * values['price'] + values['pool'],
        'source': 'excel_checkpoint', 'sourceRow': selected['row'],
        'sourceDone': cell(selected, 'B'), 'sourceCycleDate': trade_date,
        'sourcePeriodEnd': excel_date(cell(selected, 'E')),
        'checkpointIncludesContribution': True,
    }
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=pathlib.Path)
    parser.add_argument('--account', choices=['minsu', 'bobae'], required=True)
    parser.add_argument('--trade-date', required=True)
    parser.add_argument('--as-of', required=True)
    parser.add_argument('--funded', action='store_true')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = checkpoint(read_rows(args.workbook), args.account, args.trade_date, args.as_of, args.funded)
    result['sourceFile'] = args.workbook.name
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print('Confirmed funded checkpoint reconciles to the workbook; private output saved.')
