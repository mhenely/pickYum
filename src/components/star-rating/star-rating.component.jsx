import './star-rating.styles.css';

const StarRating = ({ rating, maxRating = 5 }) => {

  return (
    <>
      {
        [...Array(maxRating)].map((_, idx) => {
          const ratingValue = idx + 1;
          return (
            // fully fill all stars where ratingValue <= rating
            // if 
            <div key={idx} className={`star ${ratingValue <= rating ? 'active' : ratingValue - rating > 0 && ratingValue - rating < 1 ? 'partial' : 'empty'}`}>
              &#9733;
            </div>
          )
        })
      }
    </>
  )
}

export default StarRating;