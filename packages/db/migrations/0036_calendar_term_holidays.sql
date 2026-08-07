CREATE TABLE "calendar_term_holiday" (
  "term_id" varchar NOT NULL,
  "name" varchar(200) NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  CONSTRAINT "calendar_term_holiday_term_id_name_start_date_pk" PRIMARY KEY("term_id","name","start_date")
);
--> statement-breakpoint
ALTER TABLE "calendar_term_holiday" ADD CONSTRAINT "calendar_term_holiday_term_id_calendar_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."calendar_term"("id") ON DELETE cascade ON UPDATE no action;
