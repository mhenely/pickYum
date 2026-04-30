const getMostRecentDate = (accepted, restaurantId) => {
  const entries = accepted.filter((a) => String(a.restaurantId) === String(restaurantId));
  if (entries.length === 0) return null;
  const latest = entries.reduce((best, a) => {
    const d = new Date(a.date);
    return d > best ? d : best;
  }, new Date(0));
  return latest.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export default getMostRecentDate;
