import { useSelector, useDispatch } from "react-redux";
import { useState } from "react";

import { addUserAcceptance, removeUserSelection } from "../redux/slices/userInfoSlice";
import { restaurants } from "../tempData/restaurants";

// ability to see past accepted restaurants
// ability to see favorites

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

  const selectedList = useSelector(state => state.userInfo.users[0].selections);

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
    dispatch(removeUserSelection(flipId));
    setFlipResult(null);

  }

  return (
   <div>
      <h2>Selections</h2>
      <div className="selected-list">
        {
          selectedList.map((id) => {
            return (
              <div key={restaurants[id].name}>
                {restaurants[id].name}
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