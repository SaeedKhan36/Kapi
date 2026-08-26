CREATE TABLE "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"from_agent" text NOT NULL,
	"to_agent" text NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"files" jsonb,
	"depends_on" jsonb,
	"status" text,
	"reply_to" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"sandbox_id" text,
	"branch" text,
	"last_heartbeat" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "agents_run_id_agent_id_pk" PRIMARY KEY("run_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"installation_id" integer NOT NULL,
	"permissions" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_owner_repo_pk" PRIMARY KEY("owner","repo")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"goal" text NOT NULL,
	"repo_url" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"integration_branch" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"sandbox_provider" text NOT NULL,
	"plan" jsonb,
	"contract" jsonb,
	"error" text,
	"pr_url" text,
	"llm_requests" integer DEFAULT 0 NOT NULL,
	"llm_tokens" integer DEFAULT 0 NOT NULL,
	"sandbox_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"touches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_to" text,
	"branch" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tasks_run_id_task_id_pk" PRIMARY KEY("run_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"name" text,
	"github_login" text,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "msg_run_ts_idx" ON "agent_messages" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "msg_reply_idx" ON "agent_messages" USING btree ("reply_to");--> statement-breakpoint
CREATE INDEX "artifact_run_idx" ON "artifacts" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "runs_user_idx" ON "runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("run_id","status");