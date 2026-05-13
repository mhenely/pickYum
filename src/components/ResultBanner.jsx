const ResultBanner = ({ label, winnerId, onAccept, onRemove, restaurantMap = {} }) => {
  const r = winnerId ? restaurantMap[winnerId] : null;
  return (
    <div className="text-center mt-1">
      <p className="text-xl font-bold text-gray-900">{label}</p>
      {r ? (
        <>
          <p className="text-gray-600 mt-1 text-sm">
            You got <span className="font-semibold text-orange-600">{r.name}</span>!
          </p>
          <div className="flex gap-3 justify-center mt-3">
            <button
              onClick={onAccept}
              className="px-5 py-2 rounded-lg bg-green-600 text-white font-semibold text-sm hover:bg-green-500 transition-colors"
            >
              Accept
            </button>
            <button
              onClick={onRemove}
              className="px-5 py-2 rounded-lg bg-red-100 text-red-600 font-semibold text-sm hover:bg-red-200 transition-colors"
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-400 mt-2">
          Tap <strong>H</strong> or <strong>T</strong> on a card to assign restaurants to each side.
        </p>
      )}
    </div>
  );
};

export default ResultBanner;
