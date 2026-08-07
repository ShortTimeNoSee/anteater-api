import type { database } from "@packages/db";
import { eq } from "@packages/db/drizzle";
import { calendarTerm, calendarTermHoliday } from "@packages/db/schema";
import type { z } from "zod";
import type { calendarQuerySchema } from "$schema";

const toDateString = (d: Date): string => d.toISOString().split("T")[0];

type HolidayRow = typeof calendarTermHoliday.$inferSelect;

const calendarTermMapper = (term: typeof calendarTerm.$inferSelect, holidays: HolidayRow[]) => ({
  ...term,
  instructionStart: toDateString(term.instructionStart),
  instructionEnd: toDateString(term.instructionEnd),
  finalsStart: toDateString(term.finalsStart),
  finalsEnd: toDateString(term.finalsEnd),
  socAvailable: toDateString(term.socAvailable),
  holidays: holidays
    .filter((h) => h.termId === term.id)
    .map(({ name, startDate, endDate }) => ({ name, startDate, endDate })),
});

type CalendarServiceInput = z.infer<typeof calendarQuerySchema>;

export class CalendarService {
  constructor(private readonly db: ReturnType<typeof database>) {}

  async getCalendarTerm(input: CalendarServiceInput) {
    const { year, quarter } = input;
    const termId = `${year} ${quarter}`;
    const [term] = await this.db.select().from(calendarTerm).where(eq(calendarTerm.id, termId));
    if (!term) return null;
    const holidays = await this.db
      .select()
      .from(calendarTermHoliday)
      .where(eq(calendarTermHoliday.termId, termId));
    return calendarTermMapper(term, holidays);
  }

  async getAllCalendarTerms() {
    const [terms, holidays] = await Promise.all([
      this.db.select().from(calendarTerm),
      this.db.select().from(calendarTermHoliday),
    ]);
    return terms.map((t) => calendarTermMapper(t, holidays));
  }
}
