import { modelSettingsSchemaOwner } from "@mia-cx/protocord-model-settings/schema";
import { permissionsSchemaOwner } from "@protocord/permissions/schema";

export * from "@mia-cx/protocord-model-settings/schema";
export * from "@protocord/permissions/schema";

export const prodSchemaOwner = "@prod/app" as const;

export const schemaContributors = Object.freeze([
  permissionsSchemaOwner,
  modelSettingsSchemaOwner,
  prodSchemaOwner,
]);
