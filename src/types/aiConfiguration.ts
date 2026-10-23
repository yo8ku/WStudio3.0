/**
 * Defines the persisted identity and enabled state of an AI configuration page.
 */

export const AI_CONFIGURATION_NAME_MAX_LENGTH = 11;

/** A persisted AI configuration and its derived model connection state. */
export interface AiConfiguration {
  id: string;
  name: string;
  enabled: boolean;
  hasConnectedModel: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Editable metadata for one persisted AI configuration. */
export interface UpdateAiConfigurationRequest {
  name: string;
  enabled: boolean;
}
