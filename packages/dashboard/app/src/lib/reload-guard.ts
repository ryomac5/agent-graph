import type { FilesClient } from '../pages/files/model.ts';
import { hasUnsavedDocuments } from './file-documents.ts';
import { isDashboardReloadBlocked } from './reload-safety.ts';

export function isDashboardAutoReloadBlocked(client: FilesClient & { canReload(): boolean }, hasEditedInputs: () => boolean): boolean {
  return !client.canReload() || isDashboardReloadBlocked() || hasUnsavedDocuments(client) || hasEditedInputs();
}
