import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { useReturnTo } from '../lib/return-to';

/** In a page header: the way back to the page a link came from, named for it. Nothing on a page opened any other way. */
export function ReturnButton() {
  const navigate = useNavigate();
  const back = useReturnTo();
  if (!back) return null;
  return (
    <Button title={`Back to ${back.label}`} onClick={() => navigate(back.to)}>
      ← Back to {back.label}
    </Button>
  );
}
