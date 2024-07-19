import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux'
import { decrement, increment, incrementByAmount, decrementByAmount } from '../redux/slices/counterSlice'


const HomePage = () => {

  const [ incrementNumber, setIncrementNumber ] = useState(0);
  const [ decrementNumber, setDecrementNumber ] = useState(0);


  const count = useSelector((state) => state.counter.value)
  const dispatch = useDispatch()

  return (
    <div className='content'>
      <div>
        <button
          aria-label="Increment value"
          onClick={() => dispatch(increment())}
        >
          Increment
        </button>
        <span>{count}</span>
        <button
          aria-label="Decrement value"
          onClick={() => dispatch(decrement())}
        >
          Decrement
        </button>
        <input type='number' onChange={(e) => setIncrementNumber(e.target.value)}/>
        <button onClick={() => dispatch(incrementByAmount(Number(incrementNumber)))}>Increment By Input</button>
        <br/>
        <input type='number' onChange={(e) => setDecrementNumber(e.target.value)}/>
        <button onClick={() => dispatch(decrementByAmount(Number(decrementNumber)))}>Decrement By Input</button>
      </div>
    </div>
  )
}

export default HomePage