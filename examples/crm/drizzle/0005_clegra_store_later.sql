CREATE TABLE IF NOT EXISTS "clegra_store_later" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text NOT NULL,
	"tool" text NOT NULL,
	"args" text NOT NULL,
	"args_hash" text NOT NULL,
	"at" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"until" bigint NOT NULL,
	"author" jsonb,
	"permissions" jsonb NOT NULL,
	"proof" text,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"installation" text NOT NULL,
	"call" text,
	"confirmed_at" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clegra_store_later_due" ON "clegra_store_later" USING btree ("tenant","due_at") WHERE status = 'pending';