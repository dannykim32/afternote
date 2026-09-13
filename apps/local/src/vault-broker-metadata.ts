export const VAULT_BROKER_IDENTIFIER = "dev.afternote.vault-broker";
export const OWNER_CONTROL_IDENTIFIER = "dev.afternote.owner-control";
export const OWNER_CONTROL_MACH_SERVICE = "dev.afternote.vault-broker.owner-control";
export const CLIENT_SIGNER_IDENTIFIER = "dev.afternote.client-signer";
export const CLIENT_SIGNER_APP_NAME = "AfternoteClientSigner.app";
export const CLIENT_SIGNER_EXECUTABLE_NAME = "afternote-client-signer";
export const VAULT_BROKER_PROTOCOL_VERSION = 1;

export function validatedAppleTeamId(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("Apple Team ID must contain ten uppercase letters or digits");
  }
  return teamId;
}

export function vaultKeyAccessGroup(teamId: string): string {
  return `${validatedAppleTeamId(teamId)}.dev.afternote.vault-key`;
}

export function clientSignerAccessGroup(teamId: string): string {
  return `${validatedAppleTeamId(teamId)}.dev.afternote.client-key`;
}
