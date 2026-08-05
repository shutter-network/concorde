ALTER TABLE "saf_scheduler"."schedules" ADD COLUMN "cron_expr" text;--> statement-breakpoint
ALTER TABLE "saf_scheduler"."schedules" ADD COLUMN "tz" text;--> statement-breakpoint
ALTER TABLE "saf_scheduler"."schedules" ADD COLUMN "until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saf_scheduler"."schedules" ADD CONSTRAINT "schedules_cron_has_fields" CHECK ("saf_scheduler"."schedules"."kind" <> 'cron' or ("saf_scheduler"."schedules"."cron_expr" is not null and "saf_scheduler"."schedules"."tz" is not null and "saf_scheduler"."schedules"."at" is not null));