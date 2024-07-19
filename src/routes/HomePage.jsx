import { useSelector, useDispatch } from 'react-redux'
import { useRef } from 'react';
import { updateUserInfo, addUserReview, removeUserReview } from '../redux/slices/userInfoSlice';
import { restaurants } from '../tempData/restaurants';

// display raring as stars

const HomePage = () => {

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
          return (
            (currentUserInfo.reviews[restaurant].length > 0) && <div key={name} className='restaurant-reviews'>
              <h4>{name}:</h4> {
                currentUserInfo.reviews[restaurant].map(({ content, rating, date}) => {
                  return (
                    <div key={content} className='review-info'>
                      {content}
                      Rating: {rating}
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
    </>
  )
}

export default HomePage