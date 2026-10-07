import type { ComponentProps } from 'react';
import { Link, useInRouterContext } from 'react-router';

export function AppLink({ to, ...props }: Omit<ComponentProps<'a'>, 'href'> & { to: string }) {
  const routed = useInRouterContext();
  return routed && !to.startsWith('#') ? <Link to={to} {...props}/> : <a href={to} {...props}/>;
}
