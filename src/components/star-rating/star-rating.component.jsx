const Star = ({ fill }) => (
  <span className="relative inline-block text-gray-300">
    &#9733;
    {fill > 0 && (
      <span
        className="absolute inset-0 overflow-hidden text-amber-400"
        style={{ width: `${fill * 100}%` }}
      >
        &#9733;
      </span>
    )}
  </span>
);

const StarRating = ({ rating, maxRating = 5 }) => (
  <div className="flex">
    {[...Array(maxRating)].map((_, idx) => (
      <Star key={idx} fill={Math.min(1, Math.max(0, rating - idx))} />
    ))}
  </div>
);

export default StarRating;
