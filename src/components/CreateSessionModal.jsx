import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { sessionApi } from '../lib/sessionApi';

const CreateSessionModal = ({ flipPool, restaurantMap, defaultHostName = '', onClose }) => {
  const navigate = useNavigate();
  const [hostName, setHostName] = useState(defaultHostName);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const candidates = flipPool.map(String);

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = hostName.trim();
    if (!name) { setError('Enter your name first.'); return; }
    if (candidates.length < 2) { setError('Add at least 2 restaurants to your flip pool.'); return; }

    setLoading(true);
    setError('');
    try {
      const restaurants = {};
      for (const id of candidates) {
        const r = restaurantMap[id];
        if (r) restaurants[id] = { name: r.name, type: r.type ?? 'Restaurant', price: r.price ?? 1 };
      }
      const { session } = await sessionApi.create({ hostName: name, candidates, restaurants });
      sessionStorage.setItem(`py_voter_${session.id}`, name);
      navigate(`/vote/${session.id}`);
    } catch (err) {
      const msg = err.message ?? '';
      setError(
        msg.toLowerCase().includes('fetch')
          ? 'Cannot reach the server. Make sure it is running (npm run dev in the server/ folder).'
          : msg || 'Could not create session.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-md rounded-xl bg-white shadow-xl p-6">

          <div className="flex justify-between items-center mb-5">
            <DialogTitle className="text-lg font-semibold text-gray-900">
              Start a group vote
            </DialogTitle>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Candidate preview */}
          <div className="mb-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Tonight's candidates ({candidates.length})
            </p>
            {candidates.length === 0 ? (
              <p className="text-sm text-red-500">No restaurants in your flip pool. Add some selections and remove filters first.</p>
            ) : (
              <ul className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {candidates.map((id) => {
                  const r = restaurantMap[id];
                  return (
                    <li key={id} className="flex items-center gap-2 text-sm text-gray-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                      {r?.name ?? `Restaurant ${id}`}
                      {r?.type && <span className="text-xs text-gray-400">· {r.type}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Your name (shown to the group)
              </label>
              <input
                type="text"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                placeholder="e.g. Matt"
                maxLength={30}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <button
              type="submit"
              disabled={loading || candidates.length < 2}
              className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Creating…' : 'Create session & get invite link'}
            </button>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default CreateSessionModal;
