const InfoRow = ({ label, value, href, external }) => (
  <div>
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
      {label}
    </p>
    {href ? (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="text-sm text-orange-600 hover:underline break-all"
      >
        {value}
      </a>
    ) : (
      <p className="text-sm text-gray-800 font-medium">{value}</p>
    )}
  </div>
);

export default InfoRow;
