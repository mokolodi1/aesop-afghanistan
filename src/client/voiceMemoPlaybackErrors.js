export const VOICE_MEMO_CLIENT_ERROR_CODES = {
  MEDIA_ABORTED: 'VMCL01',
  MEDIA_NETWORK: 'VMCL02',
  MEDIA_DECODE: 'VMCL03',
  MEDIA_UNSUPPORTED: 'VMCL04',
  MEDIA_UNKNOWN: 'VMCL05',
};

/**
 * @param {number} mediaErrorCode
 * @returns {string}
 */
export function voiceMemoClientErrorCodeFromMediaError(mediaErrorCode) {
  switch (Number(mediaErrorCode)) {
    case 1:
      return VOICE_MEMO_CLIENT_ERROR_CODES.MEDIA_ABORTED;
    case 2:
      return VOICE_MEMO_CLIENT_ERROR_CODES.MEDIA_NETWORK;
    case 3:
      return VOICE_MEMO_CLIENT_ERROR_CODES.MEDIA_DECODE;
    case 4:
      return VOICE_MEMO_CLIENT_ERROR_CODES.MEDIA_UNSUPPORTED;
    default:
      return VOICE_MEMO_CLIENT_ERROR_CODES.MEDIA_UNKNOWN;
  }
}

/**
 * @param {number} mediaErrorCode
 * @param {{ streamStatus?: number, contentType?: string }} [details]
 * @returns {string}
 */
export function logVoiceMemoClientPlaybackError(mediaErrorCode, details = {}) {
  const errorCode = voiceMemoClientErrorCodeFromMediaError(mediaErrorCode);
  console.warn(
    `[voice-memo-client] ${errorCode} mediaError=${Number(mediaErrorCode) || 0} ` +
      `streamStatus=${details.streamStatus ?? '?'} contentType=${details.contentType || 'unknown'}`,
  );
  return errorCode;
}
