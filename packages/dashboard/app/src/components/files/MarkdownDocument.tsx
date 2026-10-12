import { lazy, Suspense, type ComponentProps } from 'react';
import { LoadingFeature } from '../LoadingFeature.tsx';
import { FeatureErrorBoundary } from '../FeatureErrorBoundary.tsx';
import './document.css';

const MarkdownEditor = lazy(() => import('./MarkdownEditor.tsx').then(module => ({ default: module.MarkdownDocument })));

export function MarkdownDocument(props: ComponentProps<typeof MarkdownEditor>) {
  return <FeatureErrorBoundary><Suspense fallback={<LoadingFeature language={props.language}/>}><MarkdownEditor {...props}/></Suspense></FeatureErrorBoundary>;
}
