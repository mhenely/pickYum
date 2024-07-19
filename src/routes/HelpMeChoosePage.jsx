import { useSelector, useDispatch } from "react-redux";
import { useState } from "react";

import { changeZeroIndex, removeSelection } from "../redux/slices/chooseModalSlice";

const HelpMeChoosePage = () => {
  const [ flipResult, setFlipResult ] = useState(null)


  const selectedList = useSelector(state => state.chooseModal.selections)
  const heads = selectedList[0] || null;
  const tails = selectedList[1] || null;
  
  const dispatch = useDispatch();


  const handleFlip = () => {
    if (tails) {
      const headsOrTails = {
        0: heads.name,
        1: tails.name
      }
      const flip = headsOrTails[Math.floor(Math.random() * 2)]
      setFlipResult(flip)
    }
  }

  const handleSelctionRemoval = () => {

    dispatch(removeSelection(flipResult));
    setFlipResult(null);
  }

  return (
   <div>
      <button onClick={() => dispatch(changeZeroIndex())}>Change 0 Index</button>
      <h2>Selections</h2>
      <div className="selected-list">
        {
          selectedList.map(({name}) => {
            return (
              <div key={name}>
                {name}
              </div>
            )
          })
        }
      </div>
      <br/>
      <h2>Coin Flip</h2>
      <div className="coin-flip">
        <div className="heads-and-tails">
          Heads: {heads && <div>{heads.name}</div>}
          Tails: {tails && <div>{tails.name}</div>}
        </div>
        <button onClick={handleFlip}>Flip Coin</button>
          { flipResult && 
              <div>
                Result: {flipResult}
                {flipResult === heads.name ? 'heads' : 'tails' }
                <button>Accept</button>
                <button onClick={handleSelctionRemoval}>Remove</button>
              </div>
          }
      </div>
   </div>
  )
}

export default HelpMeChoosePage;