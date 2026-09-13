/** Strip one trailing media extension embedded before a subtitle extension. */
export function stripTrailingMediaExtension(baseName: string): string {
  return baseName.replace(/^(.+)\.(wav|mp3|flac|m4a|aac|ogg|opus|wma|mp4|mkv|avi|mov|wmv|webm|m4v|ts|m2ts)$/i, '$1');
}
