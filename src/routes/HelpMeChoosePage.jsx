import { useSelector, useDispatch } from "react-redux";
import { useState } from "react";

import { removeSelection } from "../redux/slices/chooseModalSlice";

const HelpMeChoosePage = () => {
  const [ flipResult, setFlipResult ] = useState(null)


  const selectedList = useSelector(state => state.chooseModal.selections)
  
  const selectionsForFlip = [selectedList[0], selectedList[1]]
  const dispatch = useDispatch();


  const handleFlip = () => {
    setFlipResult(selectionsForFlip[Math.floor(Math.random() * 2)].name)
  }

  const handleSelctionRemoval = () => {

    dispatch(removeSelection(flipResult));
    setFlipResult(null);
  }

  return (
   <div>
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
        {
          selectionsForFlip.map((selection, idx) => {
            return (
              <div key={selection.name + idx}>
                {selection.name}
              </div>
            )
          })
        }
        <button onClick={handleFlip}>Flip Coin</button>
          { flipResult && 
              <div>
                Result: {flipResult}
                <button>Accept</button>
                <button onClick={handleSelctionRemoval}>Remove</button>
              </div>
          }
      </div>
   </div>
  )
}

export default HelpMeChoosePage;