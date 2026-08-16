// SPEC: 审计、账本、对账这类页面，运营的最后一步是"拉个 CSV 给财务 / 法务"。
// INTENT: 全站零导出，运营只能框选表格粘进表格软件 —— 粘出来的列会错位，而且只有当前一屏。
// INVARIANT: 编码规则集中在这里。含逗号 / 引号 / 换行的字段必须加引号并把 " 转义成 ""，
//            否则一个带逗号的 reason 就能把整份证据的列错开。

export type CsvColumn<Row> = {
  /** Column header written into the file — not translated: 收件人是表格软件和法务，不是界面。 */
  header: string;
  value: (row: Row) => string;
};

function escape(field: string) {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const lines = [
    columns.map((column) => escape(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => escape(column.value(row))).join(",")),
  ];
  // CRLF：Excel 之外的工具都接受，Excel 只接受这个。
  return lines.join("\r\n");
}

// SPEC: 带 UTF-8 BOM 落盘。
// INTENT: 不带 BOM 时 Excel 会按本地代码页解释，中文 reason 全成乱码 —— 这是导出功能最常见的投诉。
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** `audit-log-2026-08-16.csv` —— 文件名自带日期，运营桌面上不会堆出五个同名文件。 */
export function csvFilename(prefix: string, now = new Date()) {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}
