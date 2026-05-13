import { useState, useEffect } from 'react';

const STORAGE_KEY = 'pickyum_onboarded';

const STEPS = [
  {
    icon: '🍽️',
    title: 'Welcome to pickYum',
    body: "Can't decide where to eat? pickYum picks for you. Here's how it works in four quick steps.",
  },
  {
    icon: '🔍',
    title: 'Find restaurants',
    body: 'Use the Search page to browse nearby spots or look up places by name. Favorites you heart will appear on the Choose page for quick access.',
  },
  {
    icon: '📋',
    title: 'Build your options',
    body: 'Add restaurants to your options — these are the contenders for tonight. You can filter or individually check which ones go into the flip pool.',
  },
  {
    icon: '🪙',
    title: 'Flip & accept',
    body: 'Flip a coin or spin the roulette on the Choose page. Accept the winner to log it to your history, or spin again until you like the result.',
  },
];

const OnboardingModal = () => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setOpen(true);
    }
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  if (!open) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" onClick={dismiss} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden">

        {/* Progress bar */}
        <div className="h-1 bg-gray-100">
          <div
            className="h-full bg-orange-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="px-8 py-8">
          <div className="text-5xl mb-5 text-center">{current.icon}</div>
          <h2 className="text-xl font-bold text-gray-900 text-center mb-2">{current.title}</h2>
          <p className="text-sm text-gray-500 text-center leading-relaxed">{current.body}</p>

          <div className="mt-8 flex items-center justify-between">
            <button
              onClick={dismiss}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Skip
            </button>

            {/* Step dots */}
            <div className="flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i === step ? 'bg-orange-500' : 'bg-gray-200 hover:bg-gray-300'
                  }`}
                />
              ))}
            </div>

            <button
              onClick={() => (isLast ? dismiss() : setStep((s) => s + 1))}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-500 transition-colors"
            >
              {isLast ? "Let's go" : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingModal;
