import { useSelector, useDispatch } from "react-redux";
import { useState } from "react";

import { addUserAcceptance, addUserSelection, removeUserSelection, updateUserFavorites } from "../redux/slices/userInfoSlice";
import { restaurants } from "../tempData/restaurants";

// ability to turn off connections to food/app
  // user can manually enter in choices and use the coin flip or roulette wheel for any choice unrelated to food selections

const HelpMeChoosePage = () => {
  const [ flipResult, setFlipResult ] = useState(null)

  
  let flipId;
  Object.keys(restaurants).forEach((key)=> {
    if (restaurants[key].name === flipResult) {
      flipId = key;
    } else{
      return;
    }
  })

  const userInfo = useSelector(state => state.userInfo.users[0]);
  const selectedList = userInfo.selections;

  const heads = selectedList[0] || null;
  const tails = selectedList[1] || null;
  

  const dispatch = useDispatch();


  const handleFlip = () => {
    if (tails) {
      const headsOrTails = {
        0: restaurants[heads].name,
        1: restaurants[tails].name
      }
      const flip = headsOrTails[Math.floor(Math.random() * 2)]
      setFlipResult(flip)
    }
  }

  const handleSelctionRemoval = () => {
    dispatch(removeUserSelection({id: flipId}));
    setFlipResult(null);

  }

  return (
   <div>
      <div className="favorites-list">
        <h2>Favorites</h2>
        {
          userInfo.favorites.map((id) => {
            return (
              <div key={restaurants[id].name + id}>
                <span onClick={() => dispatch(addUserSelection(id))}>{restaurants[id].name}</span>
                <button onClick={() => dispatch(updateUserFavorites({restaurantId: id}))}>X</button>
              </div>
            )
          })
        }
      </div>
      <h2>Selections</h2>
      <div className="selected-list">
        {
          selectedList.map((id) => {
            return (
              <div key={restaurants[id].name}>
                {restaurants[id].name}
                <button onClick={() => dispatch(removeUserSelection({id}))}>X</button>
              </div>
            )
          })
        }
      </div>
      <br/>
      <h2>Coin Flip</h2>
      <div className="coin-flip">
        <div className="heads-and-tails">
          Heads: {heads && <div>{restaurants[heads].name}</div>}
          Tails: {tails && <div>{restaurants[tails].name}</div>}
        </div>
        <button onClick={handleFlip}>Flip Coin</button>
          { flipResult && 
              <div>
                Result: {flipResult}
                <button onClick={() => dispatch(addUserAcceptance({name: flipId}))}>Accept</button>
                <button onClick={handleSelctionRemoval}>Remove</button>
              </div>
          }
      </div>
   </div>
  )
}

export default HelpMeChoosePage;