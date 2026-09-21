/**
 * Paperclip is being retired (docs/adr/0001-djimitflo-core-retire-paperclip.md). Djimitflo now takes work in natively;
 * the JSONL "Paperclip-ready" export files are legacy and only written when this flag is on or a caller passes an
 * explicit path. In production those files landed in the container's HOME, where nothing ever shipped them.
 */
export function paperclipExportEnabled(): boolean {
  return process.env.PAPERCLIP_EXPORT_ENABLED === 'true';
}
