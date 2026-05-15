import { useEffect } from 'react';
import './App.styles.css';
import Navigation from './components/Navigation';
import OnboardingModal from './components/OnboardingModal';
import ChosenCelebration from './components/ChosenCelebration';
import Toaster from './components/Toaster';
import { checkAuth } from './redux/slices/authSlice';
import { loadFlags } from './redux/slices/flagsSlice';
import { useAppDispatch } from './redux/hooks';

function App() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch(checkAuth());
    // Load feature flags in parallel with auth. Independent of auth
    // state (flags are public) and failure is non-fatal — the slice
    // keeps its baked-in defaults if the fetch fails.
    dispatch(loadFlags());
  }, [dispatch]);

  return (
    <>
      <Navigation />
      <OnboardingModal />
      {/* Mounted globally so any page can pop the post-Choose-Now
          celebration by dispatching `showChosenCelebration(id)`.
          Renders nothing when celebrationSlice.chosenId is null,
          so it's effectively zero-cost for non-celebration views. */}
      <ChosenCelebration />
      {/* Sync abstraction's feedback surface — see redux/syncHelper.ts.
          Renders nothing when the toast queue is empty, so it's also
          effectively zero-cost when no background sync is failing. */}
      <Toaster />
    </>
  );
}

export default App;
