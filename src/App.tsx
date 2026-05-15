import { useEffect } from 'react';
import './App.styles.css';
import Navigation from './components/Navigation';
import OnboardingModal from './components/OnboardingModal';
import ChosenCelebration from './components/ChosenCelebration';
import { checkAuth } from './redux/slices/authSlice';
import { useAppDispatch } from './redux/hooks';

function App() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch(checkAuth());
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
    </>
  );
}

export default App;
