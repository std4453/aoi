import ExternalLoginSettings from './ExternalLoginSettings';
export default function FanboxSettings(props: { onClose: () => void; onSaved?: () => void }) {
  return <ExternalLoginSettings {...props} provider="fanbox" />;
}
