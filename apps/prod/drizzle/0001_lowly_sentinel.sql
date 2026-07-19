CREATE TABLE `mia_cx_model_configurations` (
	`guild_id` text NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`encrypted_api_key` text,
	`api_key_hint` text,
	`api_key_nonce` text,
	`api_key_auth_tag` text,
	`api_key_envelope_version` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`guild_id`, `purpose`)
);
