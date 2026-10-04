import ExternalLoginSettings from './ExternalLoginSettings';
export default function PixivSettings(props: { onClose: () => void; onSaved?: () => void }) {
  return <ExternalLoginSettings {...props} provider="pixiv" />;
}
