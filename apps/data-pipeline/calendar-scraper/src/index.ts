import { exit } from "node:process";
import { database } from "@packages/db";
import { calendarTerm, calendarTermHoliday } from "@packages/db/schema";
import { conflictUpdateSetAllCols } from "@packages/db/utils";
import { sleep } from "@packages/stdlib";
import type { CheerioAPI } from "cheerio";
import { load } from "cheerio";
import fetch from "cross-fetch";
import { diffString } from "json-diff";
import readlineSync from "readline-sync";
import sortKeys from "sort-keys";

const FIRST_YEAR = 2009;
const LAST_YEAR = 2098;

const deepSortArray = <T extends unknown[]>(array: T): T => sortKeys(array, { deep: true });

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const terms = ["Fall", "Winter", "Spring", "Summer1", "Summer10wk", "Summer2"] as const;

const SOC_AVAIL = /schedule of classes available/i;
const INST_START = /instruction begins/i;
const INST_END = /instruction ends/i;
const FINALS = /final examinations/i;
const HYPHEN = /[-–]/;
const SUMMER_SKIP =
  /schedule of classes|term begins|instruction begins|instruction ends|final exam|term ends|deadline to submit|grades available|official transcripts|degrees post|waitlist|enrollment window/i;

const parseDate = (year: number, dateString: string) =>
  new Date(
    Date.UTC(
      year,
      months.indexOf(dateString.split(" ")[0]),
      Number.parseInt(dateString.split(" ")[1], 10),
    ),
  );

const parseDateRange = (year: number, dateRangeString: string): [Date, Date] => [
  new Date(
    Date.UTC(
      year,
      months.indexOf(dateRangeString.split(" ")[0]),
      Number.parseInt(dateRangeString.split(" ")[1].split(HYPHEN)[0], 10),
    ),
  ),
  dateRangeString.split(HYPHEN)[1]?.match(/[A-Za-z]/)
    ? new Date(
        Date.UTC(
          year,
          months.indexOf(dateRangeString.split(HYPHEN)[1].split(" ")[0]),
          Number.parseInt(dateRangeString.split(HYPHEN)[1].split(" ")[1], 10),
        ),
      )
    : new Date(
        Date.UTC(
          year,
          months.indexOf(dateRangeString.split(" ")[0]),
          Number.parseInt(
            dateRangeString.split(" ")[1].split(HYPHEN)[1] ??
              dateRangeString.split(" ")[1].split(HYPHEN)[0],
            10,
          ),
        ),
      ),
];

type TermDateData = {
  year: string;
  quarter: (typeof terms)[number];
  instructionStart: Date;
  instructionEnd: Date;
  finalsStart: Date;
  finalsEnd: Date;
  socAvailable: Date;
};

type HolidayRow = {
  termId: string;
  name: string;
  startDate: string;
  endDate: string;
};

type ColInfo = {
  termId: string;
  year: number;
};

function parseHolidayDate(baseYear: number, raw: string): [string, string] | null {
  const trimmed = raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  if (!trimmed || /^tba$/i.test(trimmed)) return null;
  const parts = trimmed.split(HYPHEN);
  const startParts = parts[0].trim().split(" ");
  if (startParts.length < 2) return null;
  const startMonth = months.indexOf(startParts[0]);
  if (startMonth === -1) return null;
  const startDay = Number.parseInt(startParts[1], 10);
  if (Number.isNaN(startDay)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const startStr = `${baseYear}-${pad(startMonth + 1)}-${pad(startDay)}`;
  if (parts.length === 1) return [startStr, startStr];
  const endRaw = parts[1].trim();
  const endParts = endRaw.split(" ");
  if (endParts.length >= 2 && months.indexOf(endParts[0]) !== -1) {
    const endMonth = months.indexOf(endParts[0]);
    const endDay = Number.parseInt(endParts[1], 10);
    const endYear = endMonth < startMonth ? baseYear + 1 : baseYear;
    return [startStr, `${endYear}-${pad(endMonth + 1)}-${pad(endDay)}`];
  }
  const endDay = Number.parseInt(endRaw, 10);
  if (Number.isNaN(endDay)) return null;
  return [startStr, `${baseYear}-${pad(startMonth + 1)}-${pad(endDay)}`];
}

function cellText(html: string): string {
  return load(html).text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function parseHolidayTableRows(
  $: CheerioAPI,
  // biome-ignore lint/suspicious/noExplicitAny: cheerio element collection
  rows: any,
  cols: ColInfo[],
  skipPattern?: RegExp,
): HolidayRow[] {
  const result: HolidayRow[] = [];
  let active = skipPattern !== undefined;
  // biome-ignore lint/suspicious/noExplicitAny: cheerio callback types
  rows.each((_: number, tr: any) => {
    const cells = $(tr).find("td");
    if (cells.length === 0) return;
    const firstText = $(cells.get(0)!).text().replace(/ /g, " ").trim();
    if (!active) {
      if (/academic and administrative holidays/i.test(firstText)) active = true;
      return;
    }
    if (skipPattern?.test(firstText)) return;
    const firstHtml = $(cells.get(0)!).html() ?? "";
    const names = firstHtml
      .split(/<br\s*\/?>/i)
      .map((s) => cellText(s))
      .filter((s) => s.length > 0);
    if (names.length === 0) return;
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      const cell = cells.get(colIdx + 1);
      if (!cell) continue;
      const cellHtml = $(cell).html() ?? "";
      const dateTexts = cellHtml
        .split(/<br\s*\/?>/i)
        .map((s) => cellText(s))
        .filter((s) => s.length > 0);
      for (let i = 0; i < dateTexts.length; i++) {
        const name = names[i] ?? names[names.length - 1];
        const parsed = parseHolidayDate(cols[colIdx].year, dateTexts[i]);
        if (parsed) {
          result.push({
            termId: cols[colIdx].termId,
            name,
            startDate: parsed[0],
            endDate: parsed[1],
          });
        }
      }
    }
  });

  return result;
}

type YearData = {
  terms: TermDateData[];
  holidays: HolidayRow[];
};

async function getYearData(year: string): Promise<YearData> {
  const yearNum = Number.parseInt(year, 10);

  if (year.length !== 4 || Number.isNaN(yearNum)) {
    throw new Error("Error: Invalid year provided.");
  }

  const shortYear = year.slice(2);

  const response = await fetch(
    `https://www.reg.uci.edu/calendars/quarterly/${year}-${yearNum + 1}/quarterly${shortYear}-${Number.parseInt(shortYear, 10) + 1}.html`,
  );

  if (response.status === 404) {
    return { terms: [], holidays: [] };
  }

  const rawHtml = await response.text();
  const $ = load(rawHtml);
  const calendarTables = $("table.calendartable");

  const data = calendarTables
    .text()
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length);

  const socIdx = data.findIndex((x) => x.match(SOC_AVAIL)) + 1;
  const socSummerIdx = data.findLastIndex((x) => x.match(SOC_AVAIL)) + 1;
  const instStartIdx = data.findIndex((x) => x.match(INST_START)) + 1;
  const instStartSummerIdx = data.findLastIndex((x) => x.match(INST_START)) + 1;
  const instEndIdx = data.findIndex((x) => x.match(INST_END)) + 1;
  const instEndSummerIdx = data.findLastIndex((x) => x.match(INST_END)) + 1;
  const finalsIdx = data.findIndex((x) => x.match(FINALS)) + 1;
  const finalsSummerIdx = data.findLastIndex((x) => x.match(FINALS)) + 1;

  const term = (i: number) => `${yearNum + Number(i > 0)} ${terms[i]}`;

  const soc: Record<string, Date> = Object.fromEntries(
    [...data.slice(socIdx, socIdx + 3), ...data.slice(socSummerIdx, socSummerIdx + 3)].map(
      (x, i) => [term(i), parseDate(yearNum + Number(i > 1), x)],
    ),
  );
  const instStart: Record<string, Date> = Object.fromEntries(
    [
      ...data.slice(instStartIdx, instStartIdx + 3),
      ...data.slice(instStartSummerIdx, instStartSummerIdx + 3),
    ].map((x, i) => [term(i), parseDate(yearNum + Number(i > 0), x)]),
  );
  const instEnd: Record<string, Date> = Object.fromEntries(
    [
      ...data.slice(instEndIdx, instEndIdx + 3),
      ...data.slice(instEndSummerIdx, instEndSummerIdx + 3),
    ].map((x, i) => [term(i), parseDate(yearNum + Number(i > 0), x)]),
  );
  const finals: Record<string, [Date, Date]> = Object.fromEntries(
    [
      ...data.slice(finalsIdx, finalsIdx + 3),
      ...data.slice(finalsSummerIdx, finalsSummerIdx + 3),
    ].map((x, i) => [term(i), parseDateRange(yearNum + Number(i > 0), x)]),
  );

  const termList = Array(6)
    .fill(0)
    .map((_, i) => term(i))
    .map((x) => {
      const [y, q] = x.split(" ", 2);
      return {
        year: y,
        quarter: q as (typeof terms)[number],
        instructionStart: instStart[x],
        instructionEnd: instEnd[x],
        finalsStart: finals[x][0],
        finalsEnd: finals[x][1],
        socAvailable: soc[x],
      };
    });

  const holidays: HolidayRow[] = [];

  calendarTables.each((_, el) => {
    const tbl = $(el);
    const tblText = tbl.text();
    const rows = tbl.find("tr");
    if (tblText.includes("Academic and Administrative Holidays")) {
      const cols: ColInfo[] = [
        { termId: `${yearNum} Fall`, year: yearNum },
        { termId: `${yearNum + 1} Winter`, year: yearNum + 1 },
        { termId: `${yearNum + 1} Spring`, year: yearNum + 1 },
      ];
      holidays.push(...parseHolidayTableRows($, rows, cols, undefined));
    } else if (/Summer Session/i.test(tblText)) {
      const cols: ColInfo[] = [
        { termId: `${yearNum + 1} Summer1`, year: yearNum + 1 },
        { termId: `${yearNum + 1} Summer10wk`, year: yearNum + 1 },
        { termId: `${yearNum + 1} Summer2`, year: yearNum + 1 },
      ];
      holidays.push(...parseHolidayTableRows($, rows, cols, SUMMER_SKIP));
    }
  });

  return { terms: termList, holidays };
}

async function main() {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL not found");
  const db = database(url);
  console.log("Scraping calendar terms and holidays...");
  const allTerms: TermDateData[] = [];
  const allHolidays: HolidayRow[] = [];
  for (let i = FIRST_YEAR; i <= LAST_YEAR; ++i) {
    const data = await getYearData(i.toString(10));
    if (!data.terms.length) break;
    allTerms.push(...data.terms);
    allHolidays.push(...data.holidays);
    await sleep(1000);
  }

  const sortedTerms = deepSortArray(allTerms);
  const sortedHolidays = deepSortArray(allHolidays);

  console.log("Fetching calendar data from database...");
  const dbTerms = deepSortArray(await db.select().from(calendarTerm));
  const dbHolidays = deepSortArray(await db.select().from(calendarTermHoliday));

  const termDiff = diffString(dbTerms, sortedTerms);
  const holidayDiff = diffString(dbHolidays, sortedHolidays);

  if (!termDiff.length && !holidayDiff.length) {
    console.log("No difference found between database and scraped calendar data.");
    console.log("All done!");
    exit();
  }

  if (termDiff.length) {
    console.log("Difference between database and scraped calendar term data:");
    console.log(termDiff);
  }
  if (holidayDiff.length) {
    console.log("Difference between database and scraped holiday data:");
    console.log(holidayDiff);
  }

  if (!readlineSync.keyInYNStrict("Is this ok")) {
    console.log("Cancelling scraping run.");
    exit(1);
  }

  console.log("Writing scraped data to database...");
  await db
    .insert(calendarTerm)
    .values(allTerms)
    .onConflictDoUpdate({
      target: [calendarTerm.id],
      set: conflictUpdateSetAllCols(calendarTerm),
    });
  if (allHolidays.length) {
    await db
      .insert(calendarTermHoliday)
      .values(allHolidays)
      .onConflictDoUpdate({
        target: [
          calendarTermHoliday.termId,
          calendarTermHoliday.name,
          calendarTermHoliday.startDate,
        ],
        set: conflictUpdateSetAllCols(calendarTermHoliday),
      });
  }
  console.log("All done!");
  exit();
}

main().then();
