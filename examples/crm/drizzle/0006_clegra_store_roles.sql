CREATE TABLE IF NOT EXISTS "clegra_store_roles" (
	"tenant" text NOT NULL,
	"sub" text NOT NULL,
	"admin" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text,
	"email" text,
	"company_role" text,
	"seen_at" timestamp with time zone,
	"assigned" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clegra_store_roles_tenant_sub_pk" PRIMARY KEY("tenant","sub")
);
