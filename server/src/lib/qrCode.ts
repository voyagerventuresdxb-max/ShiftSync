import QRCode from 'qrcode';

/** Renders a URL as a QR code data-URL PNG, ready to drop straight into an <img src>. */
export async function generateQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { margin: 1, width: 320 });
}
