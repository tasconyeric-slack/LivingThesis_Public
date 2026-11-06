import pytest
from pydantic import ValidationError
from hosted.models import Standing, Structure
from hosted.tests.test_hosted_api import standing as small_standing

def test_standing_allows_the_aggregate_but_a_model_proposed_structure_stays_capped():
    def build(model, per_driver, aggregate):
        body = {k: v for k, v in small_standing().items() if k not in {"ticker", "version"}}
        body["drivers"] = [{**d, "falsifiers": [f"Condition {i}.{k}" for k in range(n)]}
                           for i, (d, n) in enumerate(zip(body["drivers"] * 2, per_driver), 1)]
        body["falsifiers"] = [f"Thesis condition {k}" for k in range(aggregate)]
        if model is Standing:
            body["ticker"] = "TEST"
        return model.model_validate(body)
    assert build(Standing, [2, 1, 3], 8)
    assert build(Standing, [5, 5, 5], 25)
    with pytest.raises(ValidationError):
        build(Standing, [5, 5, 5], 26)
    with pytest.raises(ValidationError):
        build(Standing, [6, 1, 1], 8)
    assert build(Structure, [2, 1, 2], 5)
    with pytest.raises(ValidationError):
        build(Structure, [2, 1, 2], 8)
