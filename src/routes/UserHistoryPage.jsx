import { useSelector, useDispatch } from 'react-redux'
import { useRef } from 'react';
import { updateUserInfo, addUserReview, removeUserReview, updateUserFavorites, addUserSelection } from '../redux/slices/userInfoSlice';
import { addSelection } from '../redux/slices/chooseModalSlice';
import { restaurants } from '../tempData/restaurants';
import StarRating from '../components/star-rating/star-rating.component';

const UserHistoryPage = () => {
  const currentUserInfo = useSelector(state => state.userInfo.users[0]);
  const restaurantInputRef = useRef();
  const ratingInputRef = useRef();
  const dateInputRef = useRef();
  const contentInputRef = useRef();

  const dispatch = useDispatch()

  const handleAddReviewSubmit = (e) => {
    e.preventDefault();
    
    // below is the name, need to get correct id
  let restaurantId;
  Object.keys(restaurants).forEach((key) => {
  if (restaurants[key].name === restaurantInputRef.current.value) {
    restaurantId = key;
  } else {
    return;
  }
  })
    const content = contentInputRef.current.value;
    const date = dateInputRef.current.value || new Date();
    const rating = Number(ratingInputRef.current.value)
    const userId = currentUserInfo.id;

    contentInputRef.current.value = '';
    dateInputRef.current.value = ''
    ratingInputRef.current.value = '';
    restaurantInputRef.current.value = '';

    dispatch(addUserReview({ restaurantId, content, date, rating, userId}))
  }

  return (
    <>
    <form onSubmit={handleAddReviewSubmit}>
      Restuarant: <input type='text' name='restaurant' ref={restaurantInputRef} required={true}/>
      Review: <input type='text' name='content' ref={contentInputRef} required={true}/>
      Rating: <input type='number' min={1} max={5} name='rating' ref={ratingInputRef} required={true}/>
      Date: <input type='date' date='date' ref={dateInputRef}/>
      <button type='submit'>Add Review</button>
    </form>
    <div className='review-list'>
      Reviews: {
        Object.keys(currentUserInfo.reviews).map((restaurant) => {
          const name = restaurants[restaurant].name
          const favorited = currentUserInfo.favorites.find((id) => id == restaurant)
          let avgRating = currentUserInfo.reviews[restaurant].reduce((acc, curr) => acc + curr.rating, 0) / currentUserInfo.reviews[restaurant].length;
          return (
            (currentUserInfo.reviews[restaurant].length > 0) && <div key={name} className='restaurant-reviews'>
              <h4 onClick={() => dispatch(addUserSelection(restaurant))}>{name}:</h4><StarRating rating={avgRating} />
              <div className={`heart ${favorited ? 'favorite' : 'empty'}`} onClick={() => dispatch(updateUserFavorites({userId: currentUserInfo.id, restaurantId: restaurant}))}>&#9829;</div>
              {
                currentUserInfo.reviews[restaurant].map(({ content, rating, date}) => {
                  return (
                    <div key={content + date} className='review-info'>
                      {content}
                      Rating: <StarRating rating={rating}/>
                      Date: {date}
                      <button onClick={() => dispatch(removeUserReview({restaurantId: restaurant, content, userId: currentUserInfo.id}))}>X</button>
                    </div>
                  )
                })
              }
            </div>
          )
        })
      }
    </div>
    <div className='accepted'>
      Accepted: {
        currentUserInfo.accepted.map((accepted) => {
          return (
            <div key={accepted.restaurantId} onClick={() => dispatch(addUserSelection(accepted.restaurantId))}>
              Name: {restaurants[accepted.restaurantId].name}
              Date: {accepted.date}
            </div>
          )
        })
      }
    </div>
    </>
  )
}

export default UserHistoryPage;