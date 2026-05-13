import { useEffect } from 'react';
import './App.styles.css';
import Navigation from './components/Navigation';
import OnboardingModal from './components/OnboardingModal';
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
    </>
  );
}

export default App;
