# Test-set results (MovieLens latest-small, per-user temporal split)

Users evaluated: 579. Model selected on validation NDCG@10: **hybrid**, test NDCG@10 +57.8% vs. popularity baseline.

| Model | Params | precision@10 | recall@10 | ndcg@10 | hit_rate@10 | coverage@10 |
|---|---|---|---|---|---|---|
| popularity | `{}` | 0.0491 | 0.0481 | 0.0651 | 0.3143 | 0.0056 |
| item_knn | `{"k": 25, "shrink": 10}` | 0.0750 | 0.0775 | 0.0957 | 0.4473 | 0.0600 |
| pure_svd | `{"n_factors": 32}` | 0.0807 | 0.0879 | 0.1045 | 0.4680 | 0.0420 |
| content_tfidf | `{"genre_weight": 1}` | 0.0085 | 0.0079 | 0.0098 | 0.0777 | 0.2023 |
| hybrid | `{"weights": {"item_knn": 0.6, "pure_svd": 0.4, "content_tfidf": 0.0}}` | 0.0801 | 0.0861 | 0.1027 | 0.4801 | 0.0521 |
