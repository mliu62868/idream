import { describe, expect, it } from "vitest";
import { csvFilename, toCsv, type CsvColumn } from "./csv";

type Row = { id: string; reason: string };

const columns: readonly CsvColumn<Row>[] = [
  { header: "event_id", value: (row) => row.id },
  { header: "reason", value: (row) => row.reason },
];

describe("toCsv", () => {
  it("writes the header row and one line per record", () => {
    expect(toCsv(columns, [{ id: "e1", reason: "duplicate" }]))
      .toBe("event_id,reason\r\ne1,duplicate");
  });

  // SPEC: 一个带逗号的 reason 就能把整份证据的列错开 —— 引用规则必须在这里守住。
  it("quotes fields containing a comma, a quote, or a newline", () => {
    const csv = toCsv(columns, [
      { id: "e1", reason: "refund, then archive" },
      { id: "e2", reason: 'operator said "no"' },
      { id: "e3", reason: "line one\nline two" },
    ]);

    expect(csv).toContain('"refund, then archive"');
    expect(csv).toContain('"operator said ""no"""');
    expect(csv).toContain('"line one\nline two"');
  });

  it("still produces a usable file with no rows", () => {
    expect(toCsv(columns, [])).toBe("event_id,reason");
  });
});

describe("csvFilename", () => {
  it("stamps the day so a week of exports does not collide", () => {
    expect(csvFilename("audit-log", new Date("2026-08-16T09:30:00.000Z"))).toBe("audit-log-2026-08-16.csv");
  });
});
