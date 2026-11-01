import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';

/** The way from a page the Setup agent can fill to the Setup agent page. */
export function SetupAgentButton({ label }: { label: string }) {
  const navigate = useNavigate();
  return <Button onClick={() => navigate('/setup')}>{label}</Button>;
}
